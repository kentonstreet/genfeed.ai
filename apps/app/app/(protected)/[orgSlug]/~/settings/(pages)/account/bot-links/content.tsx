'use client';

import { useBrand } from '@contexts/user/brand-context/brand-context';
import { useAuthIdentity } from '@hooks/auth/use-auth-identity/use-auth-identity';
import { useAuthedService } from '@hooks/auth/use-authed-service/use-authed-service';
import { BotAccountLinksService } from '@services/integrations/bot-account-links.service';
import { useMutation, useQuery } from '@tanstack/react-query';
import Card from '@ui/card/Card';
import { Button } from '@ui/primitives/button';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

export default function BotAccountLinksPage() {
  const translate = useTranslations('pages.botAccountLinks');
  const { organizationId } = useBrand();
  const { userId, sessionId } = useAuthIdentity();
  const challengeId = useSearchParams().get('challenge');
  const [confirmedChallenge, setConfirmedChallenge] = useState<string | null>(
    null,
  );
  const getService = useAuthedService((token: string) =>
    BotAccountLinksService.getInstance(token),
  );
  const enabled = Boolean(userId && organizationId);
  const links = useQuery({
    queryKey: ['bot-account-links', userId, sessionId, organizationId],
    enabled,
    queryFn: async ({ signal }) => (await getService()).list(signal),
  });
  const preview = useQuery({
    queryKey: [
      'bot-account-link-challenge',
      userId,
      sessionId,
      organizationId,
      challengeId,
    ],
    enabled:
      enabled && Boolean(challengeId) && confirmedChallenge !== challengeId,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!challengeId) throw new Error('Missing account link challenge');
      return (await getService()).preview(challengeId, signal);
    },
  });
  const confirm = useMutation({
    mutationFn: async (id: string) => (await getService()).confirm(id),
    onSuccess: async (_link, id) => {
      setConfirmedChallenge(id);
      await links.refetch();
    },
  });
  const unlink = useMutation({
    mutationFn: async (id: string) => (await getService()).unlink(id),
    onSuccess: async () => {
      await links.refetch();
    },
  });
  return (
    <div className="flex flex-col gap-4 pb-10">
      <h1 className="sr-only">{translate('title')}</h1>
      <Card label={translate('title')} bodyClassName="gap-4 p-4">
        <p>{translate('description')}</p>
        {challengeId && (
          <section
            aria-label={translate('confirmTitle')}
            className="flex flex-col gap-3"
          >
            {confirmedChallenge === challengeId ? (
              <p role="status">{translate('confirmed')}</p>
            ) : preview.error || confirm.error ? (
              <p role="alert">{translate('challengeUnavailable')}</p>
            ) : preview.data ? (
              <>
                <p>{translate('confirmDescription')}</p>
                <p>
                  {translate('sender', {
                    platform: preview.data.platform,
                    remoteUserId: preview.data.remoteUserId,
                  })}
                </p>
                <Button
                  type="button"
                  withWrapper={false}
                  isDisabled={confirm.isPending}
                  onClick={() => confirm.mutate(challengeId)}
                >
                  {translate('confirm')}
                </Button>
              </>
            ) : (
              <p role="status">{translate('loading')}</p>
            )}
          </section>
        )}
        {links.error ? (
          <div role="alert">
            <p>{translate('loadError')}</p>
            <Button
              type="button"
              withWrapper={false}
              isDisabled={links.isFetching}
              onClick={() => void links.refetch()}
            >
              {translate('retry')}
            </Button>
          </div>
        ) : links.isPending ? (
          <p role="status">{translate('loading')}</p>
        ) : links.data?.length ? (
          <ul className="flex flex-col gap-3">
            {links.data.map((link) => (
              <li
                key={link.id}
                className="flex items-center justify-between gap-3"
              >
                <span>
                  {translate('sender', {
                    platform: link.platform,
                    remoteUserId: link.remoteUserId,
                  })}
                </span>
                {link.revokedAt ? (
                  <span>{translate('revoked')}</span>
                ) : (
                  <Button
                    type="button"
                    withWrapper={false}
                    isDisabled={unlink.isPending}
                    onClick={() => unlink.mutate(link.id)}
                  >
                    {translate('unlink')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>{translate('empty')}</p>
        )}
        {unlink.error && <p role="alert">{translate('mutationError')}</p>}
      </Card>
    </div>
  );
}
