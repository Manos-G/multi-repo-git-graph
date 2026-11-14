import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { CombinedResponse } from '@shared/combinedGraph';
import { CombinedApp } from './CombinedApp';
import { handleMessage, send } from './store';
import '../index.css';

// Listen before the first render (the same rule as the graph's index.tsx, #221).
window.addEventListener('message', (e: MessageEvent) => handleMessage(e.data as CombinedResponse));

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <CombinedApp />
    </StrictMode>,
  );
}
send({ type: 'ready' });
