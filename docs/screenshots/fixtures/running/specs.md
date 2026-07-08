# Specification: Auth API login validation

## Goal
Validate email format and password length on `POST /auth/login` before hitting the database.

## Acceptance criteria
- 400 for invalid email
- 400 for password shorter than 8 characters
- Existing happy-path tests still pass
