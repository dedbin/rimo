interface AuthSupportLinkProps {
  readonly recovery?: boolean;
}

export function AuthSupportLink({ recovery = false }: AuthSupportLinkProps) {
  return <a href="https://t.me/argtg_not_arctg" target="_blank" rel="noopener noreferrer"
    className="block text-center text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
    {recovery ? "Забыли пароль? Написать в поддержку" : "Помощь с регистрацией и входом"}
  </a>;
}
