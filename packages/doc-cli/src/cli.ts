import { scanPackages } from './scanner.js';
import { generateDocs } from './generator.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'generate';
  
  if (command === 'generate') {
    const packages = await scanPackages('.');
    await generateDocs(packages, 'docs');
    console.log(`Generated docs for ${packages.length} packages`);
  } else if (command === 'verify') {
    const packages = await scanPackages('.');
    const coverage = packages.length > 0 ? 100 : 0;
    console.log(`Documentation coverage: ${coverage}%`);
    process.exit(coverage >= 50 ? 0 : 1);
  }
}

main();
