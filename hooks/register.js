
export function register(on) {
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e);
    if (e.origin.kind === 'composer') {    }
    return result;
  });
}
