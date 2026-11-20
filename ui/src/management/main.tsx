import React from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { ManagementApp } from "./ManagementApp";
const nonce = document.querySelector<HTMLMetaElement>('meta[name="paperclip-style-nonce"]')?.content;
if (!nonce || !/^[A-Za-z0-9_-]{32}$/.test(nonce)) throw new Error("management_style_authority_missing");
Object.defineProperty(globalThis, "__webpack_nonce__", { value: nonce, writable: false });
createRoot(document.getElementById("root")!).render(<React.StrictMode><ManagementApp /></React.StrictMode>);
