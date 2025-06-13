import React from 'react';
globalThis.React = React;
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useTranslation } from '@/hooks/use-translation';

const changeLanguageMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: changeLanguageMock, language: 'en' }
  })
}));

describe('useTranslation', () => {
  beforeEach(() => {
    localStorage.clear();
    changeLanguageMock.mockClear();
  });

  it('updates language and localStorage', () => {
    const { result } = renderHook(() => useTranslation());
    act(() => {
      result.current.changeLanguage('ru');
    });
    expect(changeLanguageMock).toHaveBeenCalledWith('ru');
    expect(localStorage.getItem('i18nextLng')).toBe('ru');
  });
});