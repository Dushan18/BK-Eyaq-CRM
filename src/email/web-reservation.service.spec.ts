import { safeName } from './web-reservation.service';

describe('Nombre que va dentro del WhatsApp de la web', () => {
  it.each([
    ['Ana María Pérez', 'Ana María Pérez'],
    ["O'Connor-Smith", "O'Connor-Smith"],
    ['Ana visita https://estafa.example/premio', 'Ana visita https estafa'],
    ['Ganaste un premio llama al 999 888 777', 'Ganaste un premio llama'],
    ['12345 !!!', null],
    ['', null],
    [null, null],
  ])('%p queda como %p', (input, expected) => {
    expect(safeName(input)).toBe(expected);
  });
  it('se recorta a 40 caracteres', () => {
    expect(safeName('a'.repeat(60))).toHaveLength(40);
  });
});
