const { rmSync } = require('fs');

try {
  rmSync('dist/', { recursive: true, force: true });
  console.log('Build output directory removed');
} catch {
  console.error('Error removing build output directory');
}
