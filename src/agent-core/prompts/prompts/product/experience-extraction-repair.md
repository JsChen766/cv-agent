The previous output failed JSON schema validation.
Errors: {{errors}}

Please fix the issues and return a valid JSON object with a 'candidates' array.
Each candidate must have the required fields: type, title, content.
If the previous output merged the resume into one large candidate, split it into multiple candidates. Education, internship/work, each project, awards/certificates, and skills should be separate entries when present.
Preserve the original language of the user-facing fields from the source input. Do not translate Chinese experience text into English, and do not translate English proper nouns such as paper titles or journal names.
Do not add unverified external details such as paper years, DOI, author list, citation counts, impact factors, or publication metadata.
Output ONLY the corrected JSON. No markdown, no explanation.
