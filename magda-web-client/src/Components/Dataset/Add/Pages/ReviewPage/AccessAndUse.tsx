import React, { FunctionComponent } from "react";

import { State } from "../../DatasetAddCommon";

import CollapseBox from "./CollapseBox";
import CollapseItem from "./CollapseItem";

import DescriptionBox from "Components/Common/DescriptionBox";
import * as codelists from "constants/DatasetConstants";
import ValidationRequiredLabel from "../../ValidationRequiredLabel";
import { shouldValidate } from "../../ValidationManager";
import { config } from "config";
import { getFormatIcon } from "../../../View/DistributionIcon";

import "./AccessAndUse.scss";

type PropsType = {
    stateData: State;
};

const AccessAndUse: FunctionComponent<PropsType> = props => {
    const {
        dataset,
        datasetPublishing,
        licenseLevel,
        distributions,
        informationSecurity
    } = props.stateData;

    return (
        <CollapseBox
            heading="Access and use"
            stepNum={3}
            className="access-and-use"
        >
            {config.featureFlags.publishToDga ? (
                <CollapseItem className="row" alwaysShow={true}>
                    <div className="col-sm-3">
                        <div className="title-box">
                            Publish to data.gov.au as open data (*):
                        </div>
                    </div>
                    <div className="col-sm-9 content-box single-line">
                        {datasetPublishing?.publishAsOpenData?.["dga"]
                            ? "Yes"
                            : "No"}
                    </div>
                </CollapseItem>
            ) : null}

            <CollapseItem
                className="row"
                alwaysShow={shouldValidate("$.datasetPublishing.level")}
            >
                <div className="col-sm-3">
                    <div className="title-box">
                        Who can see the dataset once it is published
                        <ValidationRequiredLabel validationFieldPath="$.datasetPublishing.level" />
                        ?
                    </div>
                </div>
                <div className="col-sm-9 content-box single-line">
                    {datasetPublishing?.level
                        ? codelists.publishingLevel[datasetPublishing.level]
                        : codelists.NO_VALUE_LABEL}
                </div>
            </CollapseItem>

            <CollapseItem className="row" alwaysShow={true}>
                <div className="col-sm-3">
                    <div className="title-box">License restrictions(*):</div>
                </div>
                <div className="col-sm-9 content-box single-line">
                    {licenseLevel !== "distribution" || !distributions?.length
                        ? dataset?.defaultLicense
                            ? codelists.licenseLevel[dataset.defaultLicense]
                            : codelists.NO_VALUE_LABEL
                        : distributions.map(item => (
                              <div
                                  key={item.id}
                                  className="row distribution-licence-row"
                              >
                                  <div className="col-sm-6 distribution-licence-title-col">
                                      <img
                                          className="file-icon"
                                          src={getFormatIcon(item)}
                                      />
                                      <div>{item.title}</div>
                                  </div>
                                  <div className="col-sm-6 distribution-licence-license-col">
                                      {item?.license
                                          ? codelists.licenseLevel[item.license]
                                          : codelists.NO_VALUE_LABEL}
                                  </div>
                              </div>
                          ))}
                </div>
            </CollapseItem>

            <CollapseItem
                className="row"
                alwaysShow={shouldValidate(
                    "$.informationSecurity.classification"
                )}
            >
                <div className="col-sm-3">
                    <div className="title-box">
                        Sensitivity classification
                        <ValidationRequiredLabel validationFieldPath="$.informationSecurity.classification" />
                        :
                    </div>
                </div>
                <div className="col-sm-9 content-box single-line">
                    {informationSecurity?.classification
                        ? codelists.classification[
                              informationSecurity.classification
                          ]
                        : codelists.NO_VALUE_LABEL}
                </div>
            </CollapseItem>

            {informationSecurity?.classification === "OFFICIAL:SENSITIVE" ? (
                <CollapseItem
                    className="row"
                    alwaysShow={shouldValidate(
                        "$.informationSecurity.disseminationLimits"
                    )}
                >
                    <div className="col-sm-3">
                        <div className="title-box">
                            Dataset Sensitivity Markers
                            <ValidationRequiredLabel validationFieldPath="$.informationSecurity.disseminationLimits" />
                            :
                        </div>
                    </div>
                    <DescriptionBox
                        className="col-sm-9 content-box"
                        isAutoTruncate={false}
                        content={
                            informationSecurity?.disseminationLimits?.length
                                ? informationSecurity.disseminationLimits
                                      .map(
                                          item =>
                                              `- ${codelists.disseminationLimits[item]}`
                                      )
                                      .join("\n")
                                : codelists.NO_VALUE_LABEL
                        }
                    />
                </CollapseItem>
            ) : null}
        </CollapseBox>
    );
};

export default AccessAndUse;
