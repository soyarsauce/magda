package au.csiro.data61.magda.registry

import akka.actor.ActorSystem
import akka.http.scaladsl.Http
import akka.http.scaladsl.marshalling.Marshal
import akka.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import akka.http.scaladsl.model.{HttpMethods, HttpRequest, MessageEntity, Uri}
import akka.http.scaladsl.unmarshalling.Unmarshal
import akka.stream.ActorMaterializer
import akka.stream.scaladsl.{Sink, Source}
import scalikejdbc._
import spray.json.JsString
import au.csiro.data61.magda.model.Registry._

import scala.concurrent.{ExecutionContext, Future}
import scala.concurrent.duration._
import scala.util.{Success, Failure}
import akka.http.scaladsl.model.StatusCode
import au.csiro.data61.magda.opa.OpaTypes._
import au.csiro.data61.magda.opa.OpaQueryer
import com.typesafe.config.Config

class WebHookProcessor(
    actorSystem: ActorSystem,
    val publicUrl: Uri,
    implicit val executionContext: ExecutionContext,
    implicit val config: Config
) extends Protocols {
  private val http = Http(actorSystem)
  private implicit val materializer: ActorMaterializer =
    ActorMaterializer()(actorSystem)
  val recordPersistence: DefaultRecordPersistence.type =
    DefaultRecordPersistence

  val opaQueryer =
    new RegistryOpaQueryer()(
      config,
      actorSystem,
      executionContext,
      materializer
    )

  def sendSomeNotificationsForOneWebHook(
      id: String,
      webHook: WebHook,
      eventPage: EventsPage
  ): Future[WebHookProcessor.SendResult] = {
    val events = eventPage.events
    val relevantEventTypes = webHook.eventTypes

    val changeEvents =
      events.filter(event => relevantEventTypes.contains(event.eventType))
    val recordChangeEvents = events.filter(
      event =>
        event.eventType.isRecordEvent || event.eventType.isRecordAspectEvent
    )
    val aspectDefinitionChangeEvents =
      events.filter(event => event.eventType.isAspectDefinitionEvent)

    val aspectDefinitionIds = aspectDefinitionChangeEvents.map(
      _.data.fields("aspectId").asInstanceOf[JsString].value
    )

    // If we're including records, get a complete record with aspects for each record ID
    val recordsFuture = webHook.config.includeRecords match {
      case Some(false) | None => Future.successful(None)
      case Some(true) =>
        DB readOnly { implicit session =>
          // We're going to include two types of records in the payload:
          // 1. Records that are directly referenced by one of the events.
          // 2. Records that _link_ to a record referenced by one of the events.
          //
          // For #1, we should ignore record aspect create/change/delete events that the
          // web hook didn't request.  i.e. only consider aspects in the web hook's
          // 'aspects' and 'optionalAspects' lists.  These are "direct" events/records
          // in the code below.
          //
          // For #2, aspects/optionalAspects don't control what is returned

          val directRecordChangeEvents = recordChangeEvents.filter { event =>
            if (!event.eventType.isRecordAspectEvent)
              true
            else {
              val aspectId =
                event.data.fields("aspectId").asInstanceOf[JsString].value
              val aspects = webHook.config.aspects
                .getOrElse(List()) ++ webHook.config.optionalAspects
                .getOrElse(List())
              aspects.isEmpty || aspects.contains(aspectId)
            }
          }

          val directRecordIds = directRecordChangeEvents
            .map(_.data.fields("recordId").asInstanceOf[JsString].value)
            .toSet

          val aspects = webHook.config.aspects.getOrElse(List())
          val optionalAspects =
            webHook.config.optionalAspects.getOrElse(List())
          lazy val opaQueriesFuture = opaQueryer.queryForAspectsAsDefaultUser(
            aspects ++ optionalAspects
          )

          // Get records directly modified by these events.
          val directRecordsFuture: Future[RecordsPage[Record]] =
            if (directRecordIds.isEmpty)
              Future.successful(RecordsPage(hasMore = false, None, List()))
            else {
              opaQueriesFuture.map(
                opaQueries =>
                  recordPersistence.getByIdsWithAspects(
                    session,
                    directRecordIds,
                    opaQueries,
                    aspects,
                    optionalAspects,
                    webHook.config.dereference
                  )
              )
            }

          // If we're dereferencing, we also need to include any records that link to
          // changed records from aspects that we're including.
          val recordsFromDereferenceFuture = webHook.config.dereference match {
            case Some(false) | None => Future.successful(List[Record]())
            case Some(true) =>
              val allRecordIds = recordChangeEvents
                .map(_.data.fields("recordId").asInstanceOf[JsString].value)
                .toSet
              if (allRecordIds.isEmpty) {
                Future.successful(List())
              } else {
                Future
                  .sequence(Seq(opaQueriesFuture, directRecordsFuture))
                  .map {
                    case Seq(
                        opaQueries,
                        directRecords
                        ) =>
                      recordPersistence
                        .getRecordsLinkingToRecordIds(
                          session,
                          allRecordIds,
                          opaQueries.asInstanceOf[Seq[
                            OpaQueryPair
                          ]],
                          directRecords
                            .asInstanceOf[RecordsPage[Record]]
                            .records
                            .map(_.id),
                          webHook.config.aspects.getOrElse(List()),
                          webHook.config.optionalAspects.getOrElse(List()),
                          webHook.config.dereference
                        )
                        .records
                  }
              }
          }

          Future
            .sequence(Seq(directRecordsFuture, recordsFromDereferenceFuture))
            .map {
              case Seq(directRecords, recordsFromDereference) =>
                Some(
                  directRecords
                    .asInstanceOf[RecordsPage[Record]]
                    .records ++ recordsFromDereference
                    .asInstanceOf[List[Record]]
                )
            }
        }
    }

    val aspectDefinitions = webHook.config.includeAspectDefinitions match {
      case Some(false) | None => None
      case Some(true) =>
        DB readOnly { implicit session =>
          Some(AspectPersistence.getByIds(session, aspectDefinitionIds))
        }
    }

    val payloadFuture = recordsFuture.map(
      records =>
        WebHookPayload(
          action = "records.changed",
          lastEventId = eventPage.events.lastOption.flatMap(_.id).get, //if (events.isEmpty) webHook.lastEvent.get else events.last.id.get,
          events =
            if (webHook.config.includeEvents.getOrElse(true)) Some(changeEvents)
            else None,
          records = records,
          aspectDefinitions = aspectDefinitions,
          deferredResponseUrl = Some(
            Uri(
              s"hooks/${java.net.URLEncoder.encode(webHook.id.get, "UTF-8")}/ack"
            ).resolvedAgainst(publicUrl).toString()
          )
        )
    )

    payloadFuture.flatMap(
      payload =>
        Marshal(payload)
          .to[MessageEntity]
          .flatMap(entity => {
            val singleRequestStream = Source.single(
              HttpRequest(
                uri = Uri(webHook.url),
                method = HttpMethods.POST,
                entity = entity
              )
            )
            val responseStream =
              singleRequestStream.map((_, 1)).via(http.superPool())
            val resultStream = responseStream.mapAsync(1) {
              case (Success(response), _) =>
                if (response.status.isFailure()) {
                  response.discardEntityBytes()

                  DB localTx { session =>
                    HookPersistence
                      .setActive(session, webHook.id.get, active = false)
                  }

                  Future(WebHookProcessor.HttpError(response.status))
                } else {
                  // Try to deserialize the success response as a WebHook response.  It's ok if this fails.
                  Unmarshal(response.entity)
                    .to[WebHookResponse]
                    .map {
                      webHookResponse =>
                        if (webHookResponse.deferResponse) {
                          DB localTx { session =>
                            HookPersistence.setIsWaitingForResponse(
                              session,
                              webHook.id.get,
                              isWaitingForResponse = true
                            )
                            if (webHook.retryCount > 0) {
                              HookPersistence
                                .resetRetryCount(session, webHook.id.get)
                            }
                          }
                          WebHookProcessor.Deferred
                        } else {
                          DB localTx { session =>
                            HookPersistence.setLastEvent(
                              session,
                              webHook.id.get,
                              payload.lastEventId
                            )
                            if (webHook.retryCount > 0) {
                              HookPersistence
                                .resetRetryCount(session, webHook.id.get)
                            }
                          }
                          WebHookProcessor.NotDeferred
                        }
                    }
                    .recover {
                      case _: Throwable =>
                        // Success response that can't be unmarshalled to a WebHookResponse.  This is fine!
                        // It just means the webhook was handled successfully.
                        DB localTx { session =>
                          HookPersistence.setLastEvent(
                            session,
                            webHook.id.get,
                            payload.lastEventId
                          )
                          if (webHook.retryCount > 0) {
                            HookPersistence
                              .resetRetryCount(session, webHook.id.get)
                          }
                        }
                        WebHookProcessor.NotDeferred
                    }
                }
              case (Failure(error), _) =>
                DB localTx { session =>
                  HookPersistence
                    .setActive(session, webHook.id.get, active = false)
                }
                Future.failed(error)
            }
            resultStream.completionTimeout(60 seconds).runWith(Sink.head)
          })
    )
  }
}

object WebHookProcessor {
  sealed trait SendResult
  case object Deferred extends SendResult
  case object NotDeferred extends SendResult
  case class HttpError(statusCode: StatusCode) extends SendResult
}
