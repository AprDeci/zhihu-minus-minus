/** Only explicitly authored export errors may be shown to the user. */
export class ContentExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentExportError';
  }
}
