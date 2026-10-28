'use client';

import { useEffect } from 'react';
import { I18nextProvider } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import i18n from '../lib/i18n';

interface I18nProviderProps {
  children: React.ReactNode;
}

export const I18nProvider = ({ children }: I18nProviderProps) => {
  useEffect(() => {
    // The first render must match the server; browser preferences apply after hydration.
    const detector = new LanguageDetector(undefined, {
      order: ['localStorage', 'navigator'], caches: ['localStorage'],
    });
    const detected = detector.detect();
    const candidates = Array.isArray(detected) ? detected : [detected];
    const preferred = candidates.find((language) => language && /^(ru|en)(-|$)/i.test(language));
    const persist = (language: string) => detector.cacheUserLanguage(language);
    i18n.on('languageChanged', persist);
    void i18n.changeLanguage(preferred?.slice(0, 2).toLowerCase() ?? 'ru');
    return () => { i18n.off('languageChanged', persist); };
  }, []);

  return (
    <I18nextProvider i18n={i18n}>
      {children}
    </I18nextProvider>
  );
};
