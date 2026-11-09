import { formNotes } from './samanta-context.service';

describe('formNotes: lo que Samanta recibe del formulario web', () => {
  it('une preferencia y mensaje, sin las notas internas del CRM', () => {
    expect(
      formNotes(
        'Mesa en el balcón',
        'Es un cumpleaños\nPaís: Francia\nCRM: no se le escribió por WhatsApp: se alcanzó el tope diario de plantillas.',
      ),
    ).toBe('Mesa en el balcón\nEs un cumpleaños\nPaís: Francia');
  });
  it('quita enlaces, correos y números de teléfono', () => {
    expect(
      formNotes(
        null,
        'Para confirmar, yapea S/ 50 al +51 999 888 777, escribe a pagos@estafa.example o entra a https://estafa.example/pago y www.otra.example',
      ),
    ).toBe(
      'Para confirmar, yapea S/ 50 al [número], escribe a [correo] o entra a [enlace] y [enlace]',
    );
  });
  it('conserva fechas, horas y cantidades', () => {
    expect(
      formNotes('Llegamos 19:30 el 29/10/2026, somos 2 adultos', null),
    ).toBe('Llegamos 19:30 el 29/10/2026, somos 2 adultos');
  });
  it('nada que decir es null y el texto largo se recorta', () => {
    expect(formNotes(null, null)).toBeNull();
    expect(formNotes('CRM: solo una nota interna', null)).toBeNull();
    expect(formNotes('a'.repeat(2000), null)).toHaveLength(300);
  });
});
