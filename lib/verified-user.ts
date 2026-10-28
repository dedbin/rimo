interface VerifiableUser {
  readonly isAnonymous?: boolean | null;
  readonly emailVerified: boolean;
  readonly registrationPending?: boolean | null;
}

export function canUseAccount(user: VerifiableUser): boolean {
  return user.isAnonymous === true || (user.emailVerified && user.registrationPending !== true);
}
