import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GpuMonitor } from './components/GpuMonitor';
import './style.css';

const surface = new URLSearchParams(window.location.search).get('view') === 'gpu' ? 'gpu' : 'main';
if (window.desktop?.platform === 'darwin') {
  document.documentElement.classList.add('platform-darwin');
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary surface={surface}>
      {surface === 'gpu' ? <GpuMonitor /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);
