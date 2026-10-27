import { expect } from './expect.js';
import { describe, test } from 'node:test';
import { answer } from './wordy.js';

describe('Wordy', () => {
  test('just a number', () => {
    expect(answer('What is 5?')).toEqual(5);
  });

  test('just a zero', () => {
    expect(answer('What is 0?')).toEqual(0);
  });

  test('just a negative number', () => {
    expect(answer('What is -123?')).toEqual(-123);
  });

  test('addition', () => {
    expect(answer('What is 1 plus 1?')).toEqual(2);
  });

  test('addition with a left hand zero', () => {
    expect(answer('What is 0 plus 2?')).toEqual(2);
  });

  test('addition with a right hand zero', () => {
    expect(answer('What is 3 plus 0?')).toEqual(3);
  });

  test('more addition', () => {
    expect(answer('What is 53 plus 2?')).toEqual(55);
  });

  test('addition with negative numbers', () => {
    expect(answer('What is -1 plus -10?')).toEqual(-11);
  });

  test('large addition', () => {
    expect(answer('What is 123 plus 45678?')).toEqual(45801);
  });

  test('subtraction', () => {
    expect(answer('What is 4 minus -12?')).toEqual(16);
  });

  test('multiplication', () => {
    expect(answer('What is -3 multiplied by 25?')).toEqual(-75);
  });

  test('division', () => {
    expect(answer('What is 33 divided by -3?')).toEqual(-11);
  });

  test('multiple additions', () => {
    expect(answer('What is 1 plus 1 plus 1?')).toEqual(3);
  });

  test('addition and subtraction', () => {
    expect(answer('What is 1 plus 5 minus -2?')).toEqual(8);
  });

  test('multiple subtraction', () => {
    expect(answer('What is 20 minus 4 minus 13?')).toEqual(3);
  });

  test('subtraction then addition', () => {
    expect(answer('What is 17 minus 6 plus 3?')).toEqual(14);
  });

  test('multiple multiplication', () => {
    expect(answer('What is 2 multiplied by -2 multiplied by 3?')).toEqual(-12);
  });

  test('addition and multiplication', () => {
    expect(answer('What is -3 plus 7 multiplied by -2?')).toEqual(-8);
  });

  test('multiple division', () => {
    expect(answer('What is -12 divided by 2 divided by -3?')).toEqual(2);
  });

  test('unknown operation', () => {
    expect(() => answer('What is 52 cubed?')).toThrow(
      new Error('Unknown operation'),
    );
  });

  test('Non math question', () => {
    expect(() => answer('Who is the President of the United States?')).toThrow(
      new Error('Unknown operation'),
    );
  });

  test('reject problem missing an operand', () => {
    expect(() => answer('What is 1 plus?')).toThrow(new Error('Syntax error'));
  });

  test('reject problem with no operands or operators', () => {
    expect(() => answer('What is?')).toThrow(new Error('Syntax error'));
  });

  test('reject two operations in a row', () => {
    expect(() => answer('What is 1 plus plus 2?')).toThrow(
      new Error('Syntax error'),
    );
  });

  test('reject two numbers in a row', () => {
    expect(() => answer('What is 1 plus 2 1?')).toThrow(
      new Error('Syntax error'),
    );
  });

  test('reject postfix notation', () => {
    expect(() => answer('What is 1 2 plus?')).toThrow(
      new Error('Syntax error'),
    );
  });

  test('reject prefix notation', () => {
    expect(() => answer('What is plus 1 2?')).toThrow(
      new Error('Syntax error'),
    );
  });
});
