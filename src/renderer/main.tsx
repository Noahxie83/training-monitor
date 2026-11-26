import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { GpuMonitor } from './components/GpuMonitor';
import './style.css';

const surface = new URLSearchParams(window.location.search).get('view');
createRoot(document.getElementById('root')!).render(<React.StrictMode>{surface === 'gpu' ? <GpuMonitor /> : <App />}</React.StrictMode>);
