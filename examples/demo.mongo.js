// Click "▶ Run" above a command, or put the cursor on it and press ⌘/Ctrl+Enter
db.users.find({}, { name: 1, age: 1, _id: 0 }).sort({ age: -1 })

db.users.aggregate([{ $group: { _id: "$young", n: { $sum: 1 } } }])
