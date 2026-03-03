import { create } from 'zustand';

interface SidebarState {
  isWorkflowsExpanded: boolean;
  expandedDepartments: string[];
  expandedSections: Record<string, boolean>;
  toggleWorkflows: () => void;
  toggleDepartment: (department: string) => void;
  toggleSection: (sectionId: string) => void;
}

export const useSidebarStore = create<SidebarState>((set) => ({
  isWorkflowsExpanded: false,
  expandedDepartments: [],
  expandedSections: { workflows: true },
  toggleWorkflows: () => set((state) => ({ isWorkflowsExpanded: !state.isWorkflowsExpanded })),
  toggleDepartment: (department) =>
    set((state) => ({
      expandedDepartments: state.expandedDepartments.includes(department)
        ? state.expandedDepartments.filter((d) => d !== department)
        : [...state.expandedDepartments, department],
    })),
  toggleSection: (sectionId) =>
    set((state) => ({
      expandedSections: {
        ...state.expandedSections,
        [sectionId]: !state.expandedSections[sectionId],
      },
    })),
}));
