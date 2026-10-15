import { buildSerializer } from '@serializers/builders';
import { botAccountLinkSerializerConfig } from '@serializers/configs';
export const { BotAccountLinkSerializer } = buildSerializer(
  'server',
  botAccountLinkSerializerConfig,
);
