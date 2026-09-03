import { Navigate } from 'react-router-dom';
import { isAuthenticated } from '../lib/auth';
import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

export default function RequireAuth({ children }: Props) {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
