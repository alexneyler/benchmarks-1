export interface OutputOptions {
  json?: boolean;
}

export function printData(data: unknown, options: OutputOptions = {}): void {
  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log('No results.');
      return;
    }
    console.table(data);
    return;
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
