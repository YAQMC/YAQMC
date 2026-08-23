import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { AppRoute } from './navigation';

export type Navigate = (route: AppRoute) => void;

const NavigationContext = createContext<Navigate | null>(null);

export function NavigationProvider({
  onNavigate,
  children,
}: {
  onNavigate: Navigate;
  children: ReactNode;
}) {
  return createElement(NavigationContext.Provider, { value: onNavigate }, children);
}

export function useNavigate(): Navigate | null {
  return useContext(NavigationContext);
}
