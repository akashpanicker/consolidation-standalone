/**
 * Standalone bundle — dev user stub.
 *
 * The production hook resolves the signed-in Azure AD account via MSAL
 * and enriches it with the Graph `/me` profile. This standalone drop
 * hard-codes a dev identity so every review action attributes to a
 * non-null user and the audit trail stays useful during frontend
 * development. Swap in the real hook when re-integrating with MSAL.
 */
export interface AuthUser {
  name: string;
  email: string;
  role: string;
  initials: string;
}

const DEV_USER: AuthUser = {
  name: "Dev User",
  email: "dev@example.com",
  role: "Frontend Developer",
  initials: "DU",
};

export function useAuth(): AuthUser | null {
  return DEV_USER;
}
