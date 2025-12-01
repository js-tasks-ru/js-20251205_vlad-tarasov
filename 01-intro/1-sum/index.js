/**
 * Sum of two numbers
 *
 * @param {number} m first number
 * @param {number} n second number
 * @returns {number}
 */

class Calculator {
    constructor(a, b) {
        this.a = a;
        this.b = b;
    }

    sum() {
        return a + b;
    }
}
export const sum = (m, n) => {
    console.log(m + n);
    console.log('debug');
    return new Calculator(m + n).sum();
};
