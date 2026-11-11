import type { DraftOutput, ReservationAction } from './samanta.provider';
import { draftFields, replyText } from './samanta-drafts';
import { replies } from './samanta-reservations';

const action = (extra: Partial<ReservationAction> = {}): ReservationAction => ({
  action: 'PROPOSE',
  language: 'es',
  date: '2026-11-20',
  time: '19:30',
  people: 4,
  service: null,
  specialRequirements: null,
  ...extra,
});
const output = (extra: Partial<DraftOutput> = {}): DraftOutput => ({
  content: '',
  intent: 'RESERVATION',
  requiresHuman: false,
  missingFields: [],
  reservation: action(),
  inputTokens: 10,
  outputTokens: 5,
  ...extra,
});

describe('Samanta: texto de respaldo cuando el modelo deja content vacío', () => {
  it('un content con texto se guarda tal cual', () => {
    expect(replyText(output({ content: 'Hola' }))).toBe('Hola');
  });
  it('vacío sin transferencia (modo sombra o borrador): respaldo neutro, nunca vacío', () => {
    const fields = draftFields(output());
    expect(fields.content).toBe(replies.es.emptyReply);
    expect(fields.content.trim()).not.toBe('');
    // The rest of the model's answer is kept as it came.
    expect(fields).toMatchObject({
      intent: 'RESERVATION',
      requiresHuman: false,
      inputTokens: 10,
      outputTokens: 5,
    });
  });
  it('vacío con requiresHuman: avisa que continúa una persona', () => {
    expect(replyText(output({ requiresHuman: true }))).toBe(
      replies.es.emptyHandOff,
    );
  });
  it('usa el idioma de la conversación y, sin acción, español', () => {
    expect(replyText(output({ reservation: action({ language: 'en' }) }))).toBe(
      replies.en.emptyReply,
    );
    expect(replyText(output({ reservation: undefined }))).toBe(
      replies.es.emptyReply,
    );
  });
  it.each(['es', 'en'] as const)(
    'en %s, ningún texto de respaldo confirma la reserva',
    (language) => {
      for (const text of [
        replies[language].emptyReply,
        replies[language].emptyHandOff,
      ])
        expect(text).not.toMatch(/confirmad|confirmed|registr/i);
    },
  );
});
