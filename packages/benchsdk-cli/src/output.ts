export interface OutputOptions {
  json?: boolean;
  format?: 'json' | 'table';
}

function isJson(options: OutputOptions): boolean {
  return !!options.json || options.format === 'json';
}

export function printData(data: unknown, options: OutputOptions = {}): void {
  if (isJson(options)) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const format = options.format ?? 'table';

  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log('No results.');
      return;
    }
    if (format === 'table') {
      console.table(data);
      return;
    }
  }

  if (data === null || data === undefined) {
    console.log('No results.');
    return;
  }

  if (typeof data === 'object') {
    console.dir(data, { depth: null });
    return;
  }

  console.log(data);
}
