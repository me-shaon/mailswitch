// The main module of the Workers test project. It exports the Durable Object classes, so
// the miniflare config can bind them, as a user Worker does.
export { MailswitchIdempotency, MailswitchLimiter } from "../../../src/stores/durable-object";

export default {
  fetch(): Response {
    return new Response("mailswitch test worker");
  },
};
