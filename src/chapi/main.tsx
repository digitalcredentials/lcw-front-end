import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import ChapiPage from './ChapiPage';
import '../index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChapiPage />
  </StrictMode>
);
