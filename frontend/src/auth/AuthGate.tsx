/**
 * Standalone bundle — authentication is stubbed out.
 *
 * The production app wraps content in MSAL-backed tenant gating; this
 * standalone drop is meant for local development of the Consolidation
 * page without Azure AD. All children are rendered unconditionally and
 * the active user comes from `useAuth()` (also stubbed to a dev user).
 */
interface AuthGateProps {
  children: React.ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  return <>{children}</>;
}
