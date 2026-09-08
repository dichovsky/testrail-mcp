# TestRail

TestRail organizes test specifications, their inclusion in testing cycles, and recorded execution outcomes.

## Language

**Test Case**:
A reusable specification of what to test, including the procedure and expected outcome.
_Avoid_: Test, execution

**Test Run**:
A collection of Tests selected for a testing cycle.
_Avoid_: Test Suite, execution result

**Test**:
An instance of a Test Case within a particular Test Run.
_Avoid_: Test Case, Test Result

**Test Result**:
A record associated with a Test that can contain an execution status, comment, assignment, or other execution information.
_Avoid_: Test, Test Case status

**Attachment**:
A file stored in TestRail as supporting material associated with a TestRail record.
_Avoid_: Upload, download

**Custom Field**:
An instance-configured TestRail field that extends the information stored for a Test Case, Test, or Test Result.
_Avoid_: Arbitrary property, metadata

## Relationships

- A **Test Case** can have multiple **Tests** across different **Test Runs**.
- A **Test** belongs to one **Test Run** and represents one **Test Case**.
- A **Test** can have zero or more **Test Results**.
- A **Test Case** or **Test Result** can have zero or more **Attachments**.
- **Custom Fields** extend **Test Case**, **Test**, and **Test Result** information according to the TestRail instance's configuration.

## Example dialogue

> **Dev:** "If a Test Case passes in one Test Run, does it pass in every Test Run?"
> **Domain expert:** "No. The Test Result belongs to the Test in that particular Test Run."

## Flagged ambiguities

- "Test" and "Test Case" are distinct: the former belongs to a Test Run; the latter is the reusable specification.
- "Record a result for a case" identifies a Test through both its Test Run and Test Case; a Test Case alone does not identify the execution.
- An **Attachment** is the file associated with a record in TestRail; a local file may be its upload source or downloaded copy.

Terminology follows TestRail's [API use cases introduction](https://support.testrail.com/hc/en-us/articles/15758177606676-API-uses-cases-intro) and [Results reference](https://support.testrail.com/hc/en-us/articles/7077819312404-Results).
