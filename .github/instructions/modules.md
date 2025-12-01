# Module scopes

Use these notes to keep Copilot review suggestions aligned to the material covered in each module. Paths are under `tasks-js-3/`.

## 01-intro
Paths: `01-intro/*`
Tasks: `1-sum`
Scope: repository setup and first JS steps; simple arithmetic and syntax. Avoid DOM, classes, async patterns, or new dependencies.

## 02-javascript-data-types
Paths: `02-javascript-data-types/*`
Tasks: `1-sort-strings`, `2-pick`, `3-omit`
Scope: primitives (number/string/boolean/null/undefined), object basics and toPrimitive, string and array methods, Object.keys/values/entries, basic code style. No classes, prototypes, DOM, or async code.

## 03-objects-arrays-intro-to-testing
Paths: `03-objects-arrays-intro-to-testing/*`
Tasks: `1-create-getter`, `2-invert-object`, `3-trim-symbols`, `4-uniq`
Scope: Map/Set, destructuring, symbols, methods and `this`, constructors with `new`, closures and arrow functions, optional recursion, intro testing with Jest. Stay away from DOM and browser-only APIs.

## 04-oop-basic-intro-to-dom
Paths: `04-oop-basic-intro-to-dom/*`
Tasks: `1-column-chart`
Scope: classes (syntax, inheritance, static members, protected/private fields), prototype chain, call/apply/bind, default parameters, timers, DOM navigation and mutation basics. Do not use fetch or module bundlers yet.

## 05-dom-document-loading
Paths: `05-dom-document-loading/*`
Tasks: `1-notification`, `2-sortable-table-v1`
Scope: DOM tree traversal and search, attributes vs properties, styling via classes, ES modules import/export, script loading (`async`/`defer`), DOMContentLoaded/load/resource events. Keep solutions framework-free.

## 06-events-practice
Paths: `06-events-practice/*`
Tasks: `1-sortable-table-v2`, `2-tooltip`, `3-double-slider`
Scope: browser events, bubbling/capturing, delegation, default actions, custom events, mouse movement/drag and drop, keyboard handling, scroll, date/time utilities. Avoid fetch/async beyond simple timers.

## 07-async-code-fetch-api-part-1
Paths: `07-async-code-fetch-api-part-1/*`
Tasks: `1-column-chart`, `2-sortable-table-v3`
Scope: promises and chaining, error handling, Promise API, microtasks, async/await, dynamic imports, fetch GET and cross-origin handling, URL objects, event loop behavior. Do not rely on form APIs or routing yet.

## 08-forms-fetch-api-part-2
Paths: `08-forms-fetch-api-part-2/*`
Tasks: `1-product-form-v1`, `2-range-picker`
Scope: FormData, fetch POST/progress/abort/resume, JSON serialization, form elements and events (focus/blur/input/change/submit), timers, scroll handling. Keep dependencies minimal; avoid routing/history work.

## 09-tests-for-frontend-apps
Paths: `09-tests-for-frontend-apps/*`
Tasks: `1-product-form-v2`, `2-sortable-list`
Scope: frontend testing with Jest and helpers (jest-dom, fetch mocks), drag-and-drop interactions, ensuring components stay testable and side-effect free. Avoid introducing new packages unless required for tests.

## 10-routes-browser-history-api
Paths: `10-routes-browser-history-api/*`
Tasks: `1-dashboard-page`
Scope: routing, History API navigation, regular expressions for route matching, event handling for links/navigation. Do not add frameworks; stay within plain JS and existing tooling.

## 11-webpack
Paths: `11-webpack/*`
Tasks: course pages such as Categories, Products, Product edit, Sales
Scope: webpack-based builds with the provided config, Babel transpilation, common loaders/plugins, assembling course pages. Keep to the documented webpack/Babel/eslint stack and avoid replacing the toolchain.
