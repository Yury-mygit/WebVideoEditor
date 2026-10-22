import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthGate } from './auth';
import { Instruction } from './Instruction';
import './styles.css';

const isInstruction = /^\/instruction\/?$/i.test(location.pathname);
if (isInstruction) document.title = 'Инструкция — SlideSub';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isInstruction ? (
      <Instruction />
    ) : (
      <AuthGate>
        <App />
      </AuthGate>
    )}
  </StrictMode>,
);
