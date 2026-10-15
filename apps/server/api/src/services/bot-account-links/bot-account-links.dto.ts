import { IsObject, IsString, Matches } from 'class-validator';

export class ConfirmBotAccountLinkDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  challengeId!: string;
}
export class BotAccountLinkEventDto {
  @IsObject()
  event!: Record<string, unknown>;
}
