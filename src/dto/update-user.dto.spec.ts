import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateUserDto } from './update-user.dto';

describe('UpdateUserDto', () => {
  it('permite omitir cualquier campo', async () => {
    const dto = plainToInstance(UpdateUserDto, {});

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it.each(['firstName', 'lastName', 'email'])(
    'rechaza %s en null en lugar de dejarlo pasar al servicio',
    async (field) => {
      const dto = plainToInstance(UpdateUserDto, { [field]: null });

      const errors = await validate(dto);

      expect(errors.map((error) => error.property)).toEqual([field]);
    },
  );
});
