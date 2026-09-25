const { extractTargets, extractTime, mergeAndCleanTargets } = require('../src/messaging/classifier');

describe('Classifier Utility Functions', () => {
    describe('extractTargets', () => {
        it('should correctly extract targets and map them to their base names', () => {
            const result = extractTargets('התרעה באזור גוש דן');
            expect(result).toBe('מרכז');
        });

        it('should handle parenthesis extraction correctly', () => {
            const result = extractTargets('התרעה באזור נתניה (מזרח)');
            expect(result).toBe('שרון (מזרח)');
        });

        it('should ignore "דרום לבנון" as it is blacklisted in extraction', () => {
            const result = extractTargets('תקיפה בדרום לבנון');
            expect(result).toBe('');
        });
    });

    describe('mergeAndCleanTargets', () => {
        it('should merge targets without duplication', () => {
            const result = mergeAndCleanTargets('מרכז, שפלה', 'מרכז');
            expect(result).toBe('מרכז, שפלה');
        });

        it('should sort the merged targets', () => {
            const result = mergeAndCleanTargets('שרון', 'חיפה');
            expect(result).toBe('חיפה, שרון');
        });
    });

    describe('extractTime', () => {
        it('should extract absolute times correctly', () => {
            const result = extractTime('השיגור יגיע בשעה 22:30');
            expect(result).toBe('22:30');
        });
        
        // Note: Relative time tests are harder as they rely on Date.now(), 
        // in a real test environment we would mock the Date object.
    });
});