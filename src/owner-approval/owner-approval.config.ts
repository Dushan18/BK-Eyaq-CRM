import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { envFlag, envInteger, envValue } from '../common/env-values';

export type CustomerDecision =
  'ACCEPTED' | 'REJECTED' | 'MODIFICATION_REQUESTED';
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;

// M9.1: sending reservation requests to the owner's WhatsApp. Off by default; nothing
// else is validated while it is off.
// M9.3: the WhatsApp templates that tell a customer the owner's decision when the 24-hour
// window is closed. Off by default (they must be approved in Meta first): with them off,
// a closed window means the team is told to contact the customer.
@Injectable()
export class OwnerApprovalConfig {
  readonly enabled: boolean;
  // Name and language of the template approved in Meta (category UTILITY).
  readonly template: string;
  readonly language: string;
  // Older requests are never sent: e.g. the ones that existed before turning this on.
  readonly maxAgeHours: number;
  readonly pollSeconds: number;
  // TEMPORARY, while Meta reviews the template: the request goes to the owner as a plain
  // WhatsApp text, and only while the owner's 24-hour window is open (the owner wrote in
  // the last 24 h). With it on, the template is never used; turn it off once the template
  // is approved.
  readonly textFallback: boolean;
  readonly decisionTemplatesEnabled: boolean;
  readonly decisionTemplates: Record<CustomerDecision, string>;
  readonly decisionTemplateLanguage: string;
  constructor(config: ConfigService) {
    this.enabled = envFlag(config, 'OWNER_APPROVAL_ENABLED', false);
    this.template =
      envValue(config, 'OWNER_APPROVAL_TEMPLATE') ??
      'aprobacion_reserva_propietario';
    this.language =
      envValue(config, 'OWNER_APPROVAL_TEMPLATE_LANGUAGE') ?? 'es';
    this.maxAgeHours = this.enabled
      ? envInteger(config, 'OWNER_APPROVAL_MAX_AGE_HOURS', 24, 1, 168)
      : 24;
    this.pollSeconds = this.enabled
      ? envInteger(config, 'OWNER_APPROVAL_POLL_SECONDS', 15, 5, 300)
      : 15;
    this.textFallback = envFlag(
      config,
      'OWNER_APPROVAL_TEXT_FALLBACK_ENABLED',
      false,
    );
    this.decisionTemplatesEnabled = envFlag(
      config,
      'CUSTOMER_DECISION_TEMPLATES_ENABLED',
      false,
    );
    this.decisionTemplates = {
      ACCEPTED:
        envValue(config, 'CUSTOMER_DECISION_TEMPLATE_ACCEPTED') ??
        'reserva_aprobada',
      REJECTED:
        envValue(config, 'CUSTOMER_DECISION_TEMPLATE_REJECTED') ??
        'reserva_no_aprobada',
      MODIFICATION_REQUESTED:
        envValue(config, 'CUSTOMER_DECISION_TEMPLATE_CHANGE') ??
        'reserva_cambio_propuesto',
    };
    this.decisionTemplateLanguage =
      envValue(config, 'CUSTOMER_DECISION_TEMPLATE_LANGUAGE') ?? 'es';
    if (this.decisionTemplatesEnabled) {
      if (
        !Object.values(this.decisionTemplates).every((name) =>
          TEMPLATE_NAME.test(name),
        )
      )
        throw new Error('CUSTOMER_DECISION_TEMPLATE_* inválida');
      if (!TEMPLATE_LANGUAGE.test(this.decisionTemplateLanguage))
        throw new Error(
          'CUSTOMER_DECISION_TEMPLATE_LANGUAGE debe ser un código como es o es_PE',
        );
    }
    if (!this.enabled) return;
    if (!TEMPLATE_NAME.test(this.template))
      throw new Error('OWNER_APPROVAL_TEMPLATE inválida');
    if (!TEMPLATE_LANGUAGE.test(this.language))
      throw new Error(
        'OWNER_APPROVAL_TEMPLATE_LANGUAGE debe ser un código como es o es_PE',
      );
  }
}
