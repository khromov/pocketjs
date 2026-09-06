// The oracle bundle imports its component through this specifier; boot.ts
// resolves it to the requested file at bundle time.
declare module "vapor:app" {
  const App: unknown;
  export default App;
}
