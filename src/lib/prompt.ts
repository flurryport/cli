import * as readline from 'readline';

export function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt the user to pick one item from a list. Returns the chosen item.
 * Auto-picks if there's only one option.
 */
export async function pickFromList<T>(
  title: string,
  items: T[],
  formatter: (item: T) => string,
): Promise<T> {
  if (items.length === 0) {
    throw new Error(`No items available: ${title}`);
  }
  if (items.length === 1) {
    return items[0];
  }

  console.log(`\n${title}`);
  items.forEach((item, i) => {
    console.log(`  \x1b[1m${i + 1}\x1b[0m. ${formatter(item)}`);
  });

  const answer = await prompt(`> Pick (1-${items.length}): `);
  const idx = parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= items.length) {
    console.error('\x1b[31mInvalid selection.\x1b[0m');
    process.exit(1);
  }
  return items[idx];
}
