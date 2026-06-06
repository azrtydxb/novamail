// Must be imported before any proto/*.jsx module: those modules reference bare
// `React` / `ReactDOM` globals (verbatim from the prototype). Importing this
// first guarantees the globals exist before the proto modules evaluate.
import React from "react";
import * as ReactDOM from "react-dom";

/* eslint-disable @typescript-eslint/no-explicit-any */
(window as any).React = React;
(window as any).ReactDOM = ReactDOM;
