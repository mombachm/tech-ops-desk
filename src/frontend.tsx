import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const element = document.getElementById("root");

if (!element) {
  throw new Error("Root element not found");
}

const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

if (import.meta.hot) {
  const root = (import.meta.hot.data.root ??= createRoot(element));
  root.render(app);
} else {
  createRoot(element).render(app);
}
