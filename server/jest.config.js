/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  moduleNameMapper: {
    '^@fia/shared$': '<rootDir>/../shared/src/index.ts',
  },
  // mongodb-memory-server downloads a MongoDB binary on first run.
  testTimeout: 60000,
};
