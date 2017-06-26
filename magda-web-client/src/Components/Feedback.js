import React from 'react';
import ReactDocumentTitle from 'react-document-title';
import {config} from '../config.js';

export default class Feedback extends React.Component {
  render() {
    return (
    <ReactDocumentTitle title={config.appName + ' | feedback'}>
      <div className='container feedback'>
        <h1>Feedbacks</h1>
        <a href="mailto:data@pmc.gov.au" target="_top">Give us feedbacks</a>
      </div>
      </ReactDocumentTitle>
    );
  }
}