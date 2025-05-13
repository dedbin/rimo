import { create } from 'zustand';

const defaultValues = {id: '', title: ''};

interface RenameModalStore {
    isOpen: boolean;
    values: typeof defaultValues;
    handleOpen: (id: string, title: string) => void;
    handleClose: () => void;
}

export const useRenameModal = create<RenameModalStore>((set) => ({
    isOpen: false,
    values: defaultValues,
    handleOpen: (id: string, title: string) => set({ isOpen: true, values: { id, title } }),
    handleClose: () => set({ isOpen: false, values: defaultValues}),
    initialValues: defaultValues,
}));