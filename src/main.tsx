import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app/App';
import { LocalSettingsProvider } from './features/settings/localSettings';
import './styles/tokens.css';
import './styles/global.css';
import './styles/layout.css';
import './styles/controls.css';
import './styles/annotations.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><LocalSettingsProvider><App /></LocalSettingsProvider></React.StrictMode>,
);
