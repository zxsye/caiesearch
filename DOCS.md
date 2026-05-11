# Project Glossary & Dictionary

This document serves as a reference for common terms, abbreviations, and document types used in the **caiesearch (SchSrch)** project. Use these terms when communicating with AI agents to ensure clarity.

## 📄 Document Types (Shortcodes)
These are the codes used in the database and URLs to identify the type of past paper document.

| Code | Full Name | Description |
| :--- | :--- | :--- |
| **qp** | Question Paper | The actual exam paper containing questions. |
| **ms** | Mark Scheme | The official answers and marking criteria. |
| **er** | Examiner Report | A report detailing how candidates performed across all variants. |
| **gt** | Grade Thresholds | The minimum marks required for each grade (A, B, C, etc.). |
| **in** | Insert | Additional materials (maps, texts, images) needed for the exam. |
| **ci** | Confidential Instructions | Instructions for teachers/invigilators (e.g., for Science practicals). |
| **sp** | Specimen Paper | A sample paper released for a new syllabus version. |
| **sm** | Specimen Mark Scheme | The mark scheme for a specimen paper. |
| **ecr** | Example Candidate Responses | Sample student answers with examiner comments. |
| **lg** | Learner Guide | A guide for students on how to prepare for the syllabus. |
| **rb** | Resource Booklet | A booklet containing data or case studies. |
| **tp** | Tapescript | The transcript for listening exams. |

## 🗓️ Exam Seasons
Cambridge exams typically occur in three main series per year.

| Code | Season | Month(s) |
| :--- | :--- | :--- |
| **m** | March | February/March (India series) |
| **s** | Summer | May/June |
| **w** | Winter | October/November |
| **y** | Specimen | "Year" / Specimen papers |

## 🏗️ Technical Terms

| Term | Definition |
| :--- | :--- |
| **Subject Code** | A 4-digit ID (e.g., `0625` for Physics, `9709` for Maths). |
| **Paper Number** | The component number (e.g., Paper 1, Paper 2). |
| **Variant** | The specific version for a geographic zone (e.g., v1, v2, v3). |
| **Set** | A collection of related documents for one specific exam (Subject + Time + Paper + Variant). |
| **Ques View** | The "Question Navigator" view that breaks down a QP into individual questions. |
| **sspdf** | A custom server-side format for rendering PDF pages as SVGs with interactive text. |
| **Directory (Dir)** | Metadata describing the structure of a PDF (e.g., where questions start/end). |

## 📂 Key File Definitions
- **`lib/dbModel.js`**: Defines the Mongoose schemas for documents and indexes.
- **`view/paperutils.js`**: Core utility for formatting times, types, and sorting papers.
- **`view/paperset.jsx`**: The component that renders a "card" of related documents in search results.
- **`view/paperviewer.jsx`**: The main PDF and Question viewer.
