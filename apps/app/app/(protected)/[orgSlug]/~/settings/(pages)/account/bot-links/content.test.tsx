// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BotAccountLinksPage from './content';

const state = vi.hoisted(() => ({
  challenge: 'a'.repeat(43) as string | null,
  list: vi.fn(),
  preview: vi.fn(),
  confirm: vi.fn(),
  unlink: vi.fn(),
}));
vi.mock('next-intl', async () => {
  const { translateFromCatalog } = await import('@app-tests/next-intl.stub');
  return { useTranslations: translateFromCatalog };
});
vi.mock('next/navigation', () => ({
  useSearchParams: () =>
    new URLSearchParams(state.challenge ? { challenge: state.challenge } : {}),
}));
vi.mock('@contexts/user/brand-context/brand-context', () => ({
  useBrand: () => ({ organizationId: 'org-1' }),
}));
vi.mock('@hooks/auth/use-auth-identity/use-auth-identity', () => ({
  useAuthIdentity: () => ({ userId: 'user-1', sessionId: 'session-1' }),
}));
vi.mock('@hooks/auth/use-authed-service/use-authed-service', () => ({
  useAuthedService: () => async () => ({
    list: state.list,
    preview: state.preview,
    confirm: state.confirm,
    unlink: state.unlink,
  }),
}));
function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BotAccountLinksPage />
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(() => {
  vi.clearAllMocks();
  state.challenge = 'a'.repeat(43);
  state.list.mockResolvedValue([]);
  state.preview.mockResolvedValue({
    id: state.challenge,
    platform: 'SLACK',
    remoteUserId: 'remote-1',
    integrationId: 'installation-1',
    expiresAt: '2030-01-01T00:00:00Z',
  });
  state.confirm.mockResolvedValue({ id: 'link-1' });
  state.unlink.mockResolvedValue(undefined);
});
describe('bot account confirmation', () => {
  it('shows verified sender but never confirms merely by loading a link', async () => {
    const client = show();
    expect(
      await screen.findByText('SLACK account: remote-1'),
    ).toBeInTheDocument();
    expect(state.confirm).not.toHaveBeenCalled();
    expect(
      client
        .getQueryCache()
        .find({
          queryKey: [
            'bot-account-link-challenge',
            'user-1',
            'session-1',
            'org-1',
            state.challenge,
          ],
        }),
    ).toBeDefined();
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirm account link' }),
    );
    await waitFor(() =>
      expect(state.confirm).toHaveBeenCalledWith(state.challenge),
    );
    expect(
      await screen.findByText(
        'Account linked. Return to your private bot conversation.',
      ),
    ).toBeInTheDocument();
  });
  it('does not expose confirmation for unavailable or wrong-tenant challenges', async () => {
    state.preview.mockRejectedValue(new Error('opaque missing'));
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This confirmation is unavailable or expired.',
    );
    expect(
      screen.queryByRole('button', { name: 'Confirm account link' }),
    ).not.toBeInTheDocument();
    expect(state.confirm).not.toHaveBeenCalled();
  });
  it('retains denied confirmation as failure rather than account-linked success', async () => {
    state.confirm.mockRejectedValue(new Error('member revoked'));
    show();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Confirm account link' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This confirmation is unavailable or expired.',
    );
    expect(
      screen.queryByText(
        'Account linked. Return to your private bot conversation.',
      ),
    ).not.toBeInTheDocument();
  });
  it('unlinks only the selected owned account and refreshes its list', async () => {
    state.challenge = null;
    state.list.mockResolvedValue([
      {
        id: 'link-1',
        platform: 'TELEGRAM',
        remoteUserId: 'remote-2',
        revokedAt: null,
      },
    ]);
    show();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Unlink account' }),
    );
    await waitFor(() => expect(state.unlink).toHaveBeenCalledWith('link-1'));
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(2));
    expect(state.preview).not.toHaveBeenCalled();
  });
  it('keeps list errors distinct from no linked accounts and supports retry', async () => {
    state.challenge = null;
    state.list.mockRejectedValueOnce(new Error('offline'));
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to load your linked accounts.',
    );
    expect(
      screen.queryByText(/No bot accounts linked/),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByText(/No bot accounts linked/),
    ).toBeInTheDocument();
  });
});
