import { StrictMode } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/lib/i18n';
import { I18nProvider } from '@/providers/i18n-provider';
import { useTranslation } from '@/hooks/use-translation';

function TranslatedContent() {
  const { t, changeLanguage } = useTranslation();
  return <div><span>{t('loading')}</span><button onClick={() => changeLanguage('en')}>English</button></div>;
}

afterEach(async () => {
  cleanup();
  localStorage.clear();
  await i18n.changeLanguage('ru');
});

describe('translation hydration', () => {
  it('hydrates the Russian server render before restoring a saved English preference', async () => {
    await i18n.changeLanguage('ru');
    localStorage.setItem('i18nextLng', 'en');
    const tree = <StrictMode><I18nProvider><TranslatedContent /></I18nProvider></StrictMode>;
    const container = document.createElement('div');
    container.innerHTML = renderToString(tree);
    expect(container.textContent).toContain('Загрузка...');
    document.body.appendChild(container);
    const recoverableError = vi.fn();
    let root: Root | undefined;
    try {
      await act(async () => { root = hydrateRoot(container, tree, { onRecoverableError: recoverableError }); });
      await waitFor(() => expect(within(container).getByText('Loading...')).toBeTruthy());
      expect(recoverableError).not.toHaveBeenCalled();
      expect(localStorage.getItem('i18nextLng')).toBe('en');
    } finally {
      await act(async () => root?.unmount());
      container.remove();
    }
  });

  it('persists a language change through the provider', async () => {
    localStorage.setItem('i18nextLng', 'ru');
    const page = render(<I18nProvider><TranslatedContent /></I18nProvider>);
    fireEvent.click(page.getByRole('button', { name: 'English' }));
    await waitFor(() => expect(page.getByText('Loading...')).toBeTruthy());
    expect(localStorage.getItem('i18nextLng')).toBe('en');
  });
});
