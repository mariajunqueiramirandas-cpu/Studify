import { abortableSleep, backoffMs } from '../operation';
describe('stream reconnect backoff', () => {
  it('backs off with a bounded delay', () => { expect([1,2,3,4,5].map(backoffMs)).toEqual([1000,2000,4000,8000,8000]); });
  it('cancels an outstanding reconnect delay', async () => {
    const controller = new AbortController();
    const promise = abortableSleep(10000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
