// Vite loads a file as text with the `?raw` suffix.
declare module "*?raw" {
  const content: string;
  export default content;
}
