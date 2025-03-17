# CLAUDE.md - Valuer Agent Guidelines

## Build/Test/Lint Commands
- `npm run dev` - Run development server with tsx watch
- `npm run build` - Clean dist folder and compile TypeScript
- `npm run start` - Start the server from compiled output
- `npm run lint` - Run ESLint across all files
- `npm run test` - Run all tests with Vitest
- `npm run test src/tests/justifier-agent.test.ts` - Run specific test file

## Code Style Guidelines
- Use TypeScript with strict typing and proper interfaces
- Use ESM imports with `.js` extension (`import x from './x.js'`)
- Organize services in `/src/services/` directory
- Use JSDoc-style comments for function documentation
- Implement comprehensive error handling with try/catch blocks
- Follow camelCase for variables and methods, PascalCase for classes
- Use async/await for asynchronous operations
- Log errors with appropriate detail for debugging

## Project Structure
- Services define core business logic in isolated modules 
- Types are centralized in `types.ts`
- Test files follow the pattern `*.test.ts` and use Vitest
- Prompts for LLM interactions are in `/src/services/prompts/`