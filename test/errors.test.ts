import { describe, expect, it } from 'vitest';
import { explainError } from '../src/drivers/errors';

describe('explainError', () => {
  it('unique violations name the column and value', () => {
    expect(explainError({ code: '23505', message: 'duplicate key value violates unique constraint "users_email_key"', detail: 'Key (email)=(a@x) already exists.' }).message).toBe(
      'Duplicate value in "email": a@x — another row already has it.',
    );
    expect(explainError({ code: 'ER_DUP_ENTRY', errno: 1062, message: "Duplicate entry 'a@x' for key 'users.email'" }).message).toContain('"email": a@x');
    expect(explainError(new Error('UNIQUE constraint failed: users.email')).message).toContain('"email"');
    expect(explainError({ code: 11000, message: 'E11000 duplicate key error collection: shop.users index: name_1 dup key: { name: "An" }' }).message).toContain('"name": "An"');
  });

  it('required columns', () => {
    const e = explainError({ code: '23502', column: 'name', message: 'null value in column "name" violates not-null constraint' });
    expect(e.message).toBe('"name" is required and cannot be empty (NULL).');
    expect(e.hint).toMatch(/marked with \*/);
    expect(explainError({ errno: 1364, message: "Field 'title' doesn't have a default value" }).message).toContain('"title"');
  });

  it('foreign keys, formats and filter mistakes', () => {
    expect(explainError({ code: '23503', message: 'update or delete on table "users" violates foreign key constraint', detail: 'Key (id)=(1) is still referenced from table "orders".' }).message).toMatch(/cannot be deleted/);
    expect(explainError({ code: '22P02', message: 'invalid input syntax for type integer: "abc"' }).message).toBe('"abc" is not a valid integer.');
    expect(explainError({ code: '42703', message: 'column "nme" does not exist' }).message).toBe('There is no column named "nme".');
    expect(explainError({ errno: 1064, message: "You have an error in your SQL syntax; check the manual near 'foo'" }).hint).toMatch(/Search box/);
  });

  it('unknown errors pass through', () => {
    expect(explainError(new Error('boom'))).toEqual({ message: 'boom' });
  });
});
