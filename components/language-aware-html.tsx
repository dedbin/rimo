'use client';

import { useTranslation } from 'react-i18next';
import { useEffect } from 'react';

interface LanguageAwareHtmlProps {
  children: React.ReactNode;
}

export const LanguageAwareHtml = ({ children }: LanguageAwareHtmlProps) => {
  const { i18n } = useTranslation();

  useEffect(() => {
    document.documentElement.lang = i18n.language;
  }, [i18n.language]);

  return <>{children}</>;
};
